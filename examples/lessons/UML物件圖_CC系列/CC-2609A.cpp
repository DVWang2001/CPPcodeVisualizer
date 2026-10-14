// UML 物件圖教案 CC-2609A：2×2 矩陣的加、減、乘（陣列成員）
// （改寫自 CF 題目 CC-2609A：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
using namespace std;

class Matrix{
   int data[2][2];
public:
   void read(){
      for(int i=0;i<2;i++)
         for(int j=0;j<2;j++)
            cin>>data[i][j];
   }
   void print()const{
      for(int i=0;i<2;i++){
         cout<<" "<<data[i][0]<<" "<<data[i][1]<<endl;
      }
   }
   Matrix add(const Matrix &m) const{
      Matrix result;
      for(int i=0;i<2;i++)
         for(int j=0;j<2;j++)
            result.data[i][j]=data[i][j]+m.data[i][j];
      return result;
   }
   Matrix sub(const Matrix &m) const{
      Matrix result;
      for(int i=0;i<2;i++)
         for(int j=0;j<2;j++)
            result.data[i][j]=data[i][j]-m.data[i][j];
      return result;
   }
   Matrix mul(const Matrix &m) const{
      Matrix result;
      for(int i=0;i<2;i++){
         for(int j=0;j<2;j++){
            int sum=0;
            for(int k=0;k<2;k++)sum+=data[i][k]*m.data[k][j];
            result.data[i][j]=sum;
         }
      }
      return result;
   }
};

int main(){
   Matrix a,b;a.read();b.read();
   cout<<"a:"<<endl;a.print();cout<<endl;  //@ @guide uml:a
   cout<<"b:"<<endl;b.print();cout<<endl;
   cout<<"a+b:"<<endl;a.add(b).print();cout<<endl;
   cout<<"a-b:"<<endl;a.sub(b).print();cout<<endl;
   cout<<"a*b:"<<endl;a.mul(b).print();cout<<endl;
   return 0;
}
