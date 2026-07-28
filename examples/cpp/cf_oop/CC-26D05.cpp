#include<iostream>
#include<cmath>
using namespace std;
class Complex{public:
   double x,y;
   Complex(double a=0,double b=0):x(a),y(b){}
   Complex operator-(const Complex& b)const{return Complex(x-b.x,y-b.y);}
};
istream &operator>>(istream &is,Complex &c){
  char c1,c2;
  is>>c.x>>c1>>c.y>>c2;
  if(c1=='-')c.y*=-1;
  return is;
}
ostream& operator<<(ostream &os,Complex &a){return os<<a.x<<"/"<<a.y;}
class Arrow{public:
   Complex a,b;
   double len(){
      Complex d=a-b;
      return sqrt(d.x*d.x+d.y*d.y);
   }
};
istream& operator>>(istream &is,Arrow &a){
   return is>>a.a>>a.b;
}

int main(){
   int n;cin>>n;
   while(n--){
      Arrow ar;cin>>ar;
      cout<<ar.len()<<endl;  //@ @guide uml:ar
   }
   return 0;
}
